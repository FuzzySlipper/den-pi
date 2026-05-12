import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createSubagentRunRecorder } from '../../lib/den-subagent-recorder.ts';
import {
  buildFinalBranchHeadMetadata,
  collectFinalBranchHead,
} from '../../lib/den-subagent-final-head.ts';
import {
  addSessionArgs,
  buildSubagentPrompt,
  runPiCliSubagent,
  subagentSucceeded,
} from '../../lib/den-subagent-runner.ts';
import {
  CODER_PROMPT_SLUG,
  REVIEWER_PROMPT_SLUG,
  buildReviewerIdentity,
  ensureReviewerIdentitySection,
  fallbackPrompt,
  renderTemplate,
  reviewerIdentityGuidanceSection,
  summarizeTaskContext,
  taskMessages,
} from '../../lib/den-prompt-templates.ts';
import {
  SUBAGENT_LIFECYCLE_SCHEMA,
  SUBAGENT_LIFECYCLE_SCHEMA_VERSION,
  SUBAGENT_RUN_SCHEMA,
  SUBAGENT_RUN_SCHEMA_VERSION,
  buildReasoningCaptureMetadata,
  buildSubagentLifecycleMetadata,
  buildSubagentRunMetadata,
  classifySubagentInfrastructureFailure,
  classifySubagentStderrIssue,
  createSubagentOutputExtractor,
  isSubagentInfrastructureFailure,
  isTerminalAssistantMessage,
  normalizePiWorkEvent,
  normalizeSubagentRunEvent,
  parsePiStdoutLine,
  resolveReasoningCaptureOptions,
  subagentEventVisibility,
  subagentOperatorEventForOpsEvent,
  subagentOpsEventTypeForEvent,
  subagentRunStateFromOpsEventType,
  summarizeSubagentUsageFromSessionJsonl,
  taskThreadPacketOperatorEvent,
} from '../../lib/den-subagent-pipeline.ts';

const execFileAsync = promisify(execFile);

function assistantMessage(text, extra = {}) {
  return {
    role: 'assistant',
    model: 'gpt-test',
    stopReason: 'stop',
    content: [{ type: 'text', text }],
    ...extra,
  };
}

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

async function readJsonLines(filePath) {
  const text = await readFile(filePath, 'utf8');
  return text.trim() ? text.trim().split('\n').map((line) => JSON.parse(line)) : [];
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

test('parsePiStdoutLine preserves json and raw stdout separately', () => {
  const json = parsePiStdoutLine('{"type":"message_end","message":{"role":"assistant"}}');
  assert.equal(json?.kind, 'json');
  assert.equal(json?.line, '{"type":"message_end","message":{"role":"assistant"}}');
  assert.equal(json?.event.type, 'message_end');

  const raw = parsePiStdoutLine('not json');
  assert.deepEqual(raw, { kind: 'raw_stdout', line: 'not json' });

  assert.equal(parsePiStdoutLine('   '), undefined);
});

test('subagent work event normalizer summarizes child Pi events without prompts', () => {
  assert.deepEqual(normalizePiWorkEvent({
    type: 'tool_execution_start',
    toolCallId: 'tool-1',
    toolName: 'bash',
    args: { command: 'node --test tests/PiExtension.Tests/*.mjs' },
  }, 1234), {
    type: 'subagent.work_tool_start',
    ts: 1234,
    source_type: 'tool_execution_start',
    tool_call_id: 'tool-1',
    tool_name: 'bash',
    args_preview: '{"command":"node --test tests/PiExtension.Tests/*.mjs"}',
  });

  assert.deepEqual(normalizePiWorkEvent({
    type: 'tool_execution_end',
    toolCallId: 'tool-1',
    toolName: 'bash',
    result: { content: [{ type: 'text', text: 'ok\n' }] },
    isError: false,
  }, 1235), {
    type: 'subagent.work_tool_end',
    ts: 1235,
    source_type: 'tool_execution_end',
    tool_call_id: 'tool-1',
    tool_name: 'bash',
    result_preview: '{"content":[{"type":"text","text":"ok\\n"}]}',
    is_error: false,
  });

  assert.deepEqual(normalizePiWorkEvent({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta' },
    message: assistantMessage('Running tests now'),
  }, 1236), {
    type: 'subagent.work_message_update',
    ts: 1236,
    source_type: 'message_update',
    role: 'assistant',
    model: 'gpt-test',
    update_kind: 'text_delta',
    text_preview: 'Running tests now',
    text_chars: 17,
    content_types: ['text'],
    stop_reason: 'stop',
  });

  assert.deepEqual(normalizePiWorkEvent({
    type: 'message_update',
    assistantMessageEvent: { type: 'thinking_delta' },
    message: { role: 'assistant', provider: 'openai', model: 'gpt-test', content: [{ type: 'thinking', thinking: 'private scratchpad' }] },
  }, 1236), {
    type: 'subagent.work_reasoning_update',
    ts: 1236,
    source_type: 'message_update',
    role: 'assistant',
    provider: 'openai',
    model: 'gpt-test',
    update_kind: 'thinking_delta',
    reasoning_kind: 'thinking_delta',
    reasoning_chars: 18,
    reasoning_redacted: true,
    content_types: ['thinking'],
  });

  assert.equal(normalizePiWorkEvent({
    type: 'message_end',
    message: { role: 'user', content: [{ type: 'text', text: 'full generated prompt' }] },
  }, 1237), undefined);

  assert.deepEqual(normalizePiWorkEvent({
    type: 'turn_start',
  }, 1239, {
    runId: 'run-1',
    taskId: 824,
    subagentRole: 'coder',
    backend: 'pi-cli',
    requestedModel: 'gpt-test',
  }), {
    type: 'subagent.work_turn_start',
    ts: 1239,
    source_type: 'turn_start',
    run_id: 'run-1',
    task_id: 824,
    subagent_role: 'coder',
    backend: 'pi-cli',
    requested_model: 'gpt-test',
  });
});

test('subagent reasoning normalization can include raw local preview when config enables it', () => {
  const previous = process.env.DEN_PI_SUBAGENT_RAW_REASONING;
  delete process.env.DEN_PI_SUBAGENT_RAW_REASONING;
  try {
    assert.deepEqual(normalizePiWorkEvent({
      type: 'message_update',
      assistantMessageEvent: { type: 'reasoning_delta', delta: 'checking Den access' },
      message: { role: 'assistant', provider: 'openai', model: 'gpt-test', content: [{ type: 'reasoning', reasoning: 'checking Den access' }] },
    }, 1238, { reasoningCapture: { captureRawLocalPreviews: true, previewChars: 12 } }), {
      type: 'subagent.work_reasoning_update',
      ts: 1238,
      source_type: 'message_update',
      role: 'assistant',
      provider: 'openai',
      model: 'gpt-test',
      update_kind: 'reasoning_delta',
      reasoning_kind: 'reasoning_delta',
      reasoning_chars: 19,
      reasoning_redacted: false,
      text_preview: 'checking De…',
      content_types: ['reasoning'],
    });
  } finally {
    restoreEnv('DEN_PI_SUBAGENT_RAW_REASONING', previous);
  }
});


test('reasoning capture config preserves env compatibility override semantics', () => {
  const previous = process.env.DEN_PI_SUBAGENT_RAW_REASONING;
  try {
    delete process.env.DEN_PI_SUBAGENT_RAW_REASONING;
    assert.deepEqual(resolveReasoningCaptureOptions({ captureRawLocalPreviews: true, previewChars: 5000 }), {
      captureProviderSummaries: true,
      captureRawLocalPreviews: true,
      previewChars: 2000,
      rawEnvOverride: false,
      rawEnvValue: undefined,
    });

    process.env.DEN_PI_SUBAGENT_RAW_REASONING = '1';
    assert.equal(resolveReasoningCaptureOptions({ captureRawLocalPreviews: false }).captureRawLocalPreviews, true);
    assert.deepEqual(buildReasoningCaptureMetadata({ captureRawLocalPreviews: false }), {
      capture_provider_summaries: true,
      capture_raw_local_previews: true,
      preview_chars: 240,
      raw_env_override: true,
      raw_env_value: true,
    });

    process.env.DEN_PI_SUBAGENT_RAW_REASONING = 'off';
    assert.equal(resolveReasoningCaptureOptions({ captureRawLocalPreviews: true }).captureRawLocalPreviews, false);
  } finally {
    restoreEnv('DEN_PI_SUBAGENT_RAW_REASONING', previous);
  }
});

test('subagent reasoning normalization preserves provider-visible summaries without raw preview', () => {
  const previous = process.env.DEN_PI_SUBAGENT_RAW_REASONING;
  process.env.DEN_PI_SUBAGENT_RAW_REASONING = '1';
  const summary = 'Reviewed the affected files and test scope.';
  try {
    const event = normalizePiWorkEvent({
      type: 'message_end',
      assistantMessageEvent: { type: 'thinking_end' },
      message: {
        role: 'assistant',
        provider: 'openai',
        model: 'gpt-test',
        content: [{
          type: 'thinking',
          thinking: summary,
          thinkingSignature: JSON.stringify({ type: 'reasoning', summary: [{ type: 'summary_text', text: summary }] }),
        }],
      },
    }, 1239);

    assert.equal(event?.type, 'subagent.work_reasoning_end');
    assert.equal(event?.reasoning_redacted, true);
    assert.equal(event?.text_preview, undefined);
    assert.equal(event?.reasoning_summary_preview, summary);
    assert.equal(event?.reasoning_summary_chars, summary.length);
    assert.equal(event?.reasoning_summary_source, 'provider_visible');

    const disabled = normalizePiWorkEvent({
      type: 'message_end',
      assistantMessageEvent: { type: 'thinking_end' },
      message: {
        role: 'assistant',
        provider: 'openai',
        model: 'gpt-test',
        content: [{
          type: 'thinking',
          thinking: summary,
          thinkingSignature: JSON.stringify({ summary }),
        }],
      },
    }, 1240, { reasoningCapture: { captureProviderSummaries: false } });
    assert.equal(disabled?.reasoning_summary_preview, undefined);
    assert.equal(disabled?.text_preview, undefined);
    assert.equal(disabled?.reasoning_redacted, true);
  } finally {
    restoreEnv('DEN_PI_SUBAGENT_RAW_REASONING', previous);
  }
});

test('subagent run schema helpers emit canonical metadata and event mapping', () => {
  const artifacts = {
    dir: '/tmp/den-subagent-runs/run-1',
    stdout_jsonl_path: '/tmp/den-subagent-runs/run-1/stdout.jsonl',
    stderr_log_path: '/tmp/den-subagent-runs/run-1/stderr.log',
    status_json_path: '/tmp/den-subagent-runs/run-1/status.json',
    events_jsonl_path: '/tmp/den-subagent-runs/run-1/events.jsonl',
    session_dir: '/tmp/den-subagent-runs/run-1/sessions',
  };
  assert.deepEqual(buildSubagentRunMetadata({
    runId: 'run-1',
    role: 'planner',
    taskId: 775,
    cwd: '/repo',
    backend: 'pi-cli',
    model: 'gpt-5.5',
    sessionMode: 'fresh',
    artifacts,
  }, { output_status: 'assistant_final' }), {
    schema: SUBAGENT_RUN_SCHEMA,
    schema_version: SUBAGENT_RUN_SCHEMA_VERSION,
    run_id: 'run-1',
    role: 'planner',
    task_id: 775,
    cwd: '/repo',
    backend: 'pi-cli',
    model: 'gpt-5.5',
    tools: null,
    session_mode: 'fresh',
    session: null,
    rerun_of_run_id: null,
    review_round_id: null,
    workspace_id: null,
    worktree_path: null,
    branch: null,
    base_branch: null,
    base_commit: null,
    head_commit: null,
    purpose: null,
    artifacts,
    output_status: 'assistant_final',
  });
  assert.deepEqual(buildSubagentRunMetadata({
    runId: 'run-review',
    role: 'reviewer',
    taskId: 808,
    cwd: '/repo/worktree',
    backend: 'pi-cli',
    reviewRoundId: 135,
    workspaceId: 'workspace-1',
    worktreePath: '/repo/worktree',
    branch: 'task/808-subagent-context-metadata',
    baseBranch: 'main',
    baseCommit: 'base-sha',
    headCommit: 'head-sha',
    purpose: 'Review Follow-Up',
  }), {
    schema: SUBAGENT_RUN_SCHEMA,
    schema_version: SUBAGENT_RUN_SCHEMA_VERSION,
    run_id: 'run-review',
    role: 'reviewer',
    task_id: 808,
    cwd: '/repo/worktree',
    backend: 'pi-cli',
    model: null,
    tools: null,
    session_mode: 'fresh',
    session: null,
    rerun_of_run_id: null,
    review_round_id: 135,
    workspace_id: 'workspace-1',
    worktree_path: '/repo/worktree',
    branch: 'task/808-subagent-context-metadata',
    base_branch: 'main',
    base_commit: 'base-sha',
    head_commit: 'head-sha',
    purpose: 'review_follow_up',
    artifacts: null,
  });
  assert.deepEqual(normalizeSubagentRunEvent({
    type: 'subagent.heartbeat',
    duration_ms: 1200,
  }), {
    schema: SUBAGENT_RUN_SCHEMA,
    schema_version: SUBAGENT_RUN_SCHEMA_VERSION,
    type: 'subagent.heartbeat',
    duration_ms: 1200,
  });
  assert.equal(subagentOpsEventTypeForEvent('subagent.heartbeat'), 'subagent_heartbeat');
  assert.equal(subagentOpsEventTypeForEvent('subagent.spawn_error'), 'subagent_spawn_error');
  assert.equal(subagentOpsEventTypeForEvent('subagent.work_tool_start'), 'subagent_work_tool_start');
  assert.equal(subagentOpsEventTypeForEvent('subagent.work_message_update'), undefined);
  assert.equal(subagentOpsEventTypeForEvent('subagent.work_reasoning_update'), undefined);
  assert.equal(subagentOpsEventTypeForEvent('message_end'), undefined);
  assert.equal(subagentRunStateFromOpsEventType('subagent_assistant_output'), 'running');
  assert.equal(subagentRunStateFromOpsEventType('subagent_work_tool_start'), 'running');
  assert.equal(subagentRunStateFromOpsEventType('subagent_abort_requested'), 'aborting');
  assert.equal(subagentRunStateFromOpsEventType('subagent_rerun_requested'), 'rerun_requested');
  assert.equal(subagentRunStateFromOpsEventType('subagent_rerun_accepted'), 'rerun_accepted');
  assert.equal(subagentRunStateFromOpsEventType('subagent_rerun_unavailable'), 'failed');
  assert.equal(subagentRunStateFromOpsEventType('subagent_completed'), 'complete');
  assert.equal(subagentRunStateFromOpsEventType('subagent_failed'), 'failed');
  assert.equal(subagentRunStateFromOpsEventType('something_else'), 'unknown');
  assert.equal(subagentOperatorEventForOpsEvent('subagent_started', 'coder'), 'coder_started');
  assert.equal(subagentOperatorEventForOpsEvent('subagent_completed', 'reviewer'), 'reviewer_completed');
  assert.equal(subagentOperatorEventForOpsEvent('subagent_work_tool_start', 'coder'), undefined);
  assert.equal(taskThreadPacketOperatorEvent('coder_context_packet'), 'coder_context_prepared');
  assert.equal(taskThreadPacketOperatorEvent('implementation_packet'), 'implementation_packet_posted');
  assert.equal(taskThreadPacketOperatorEvent('validation_packet'), 'validation_completed');
  assert.equal(taskThreadPacketOperatorEvent('drift_check_packet'), 'drift_check_completed');
  assert.equal(taskThreadPacketOperatorEvent('implementation_packet_missing'), 'implementation_packet_missing_posted');
  assert.equal(subagentEventVisibility('subagent_work_tool_start'), 'debug');
  assert.equal(subagentEventVisibility('subagent_completed'), 'summary');
  assert.deepEqual(buildSubagentLifecycleMetadata('implementation_packet_posted', { message_id: 42 }), {
    schema: SUBAGENT_LIFECYCLE_SCHEMA,
    schema_version: SUBAGENT_LIFECYCLE_SCHEMA_VERSION,
    operator_event: 'implementation_packet_posted',
    event_visibility: 'summary',
    message_id: 42,
  });
});

test('subagent usage summary aggregates assistant usage from Pi session jsonl', () => {
  const summary = summarizeSubagentUsageFromSessionJsonl([
    JSON.stringify({ type: 'message', timestamp: '2026-04-26T00:00:00.000Z', message: { role: 'user', usage: { input: 1 } } }),
    JSON.stringify({ type: 'message', timestamp: '2026-04-26T00:01:00.000Z', message: { role: 'assistant', usage: { input: 100, output: 25, cacheRead: 10, cacheWrite: 5, cost: { total: 0.01, currency: 'USD' } } } }),
    JSON.stringify({ type: 'message', timestamp: '2026-04-26T00:02:00.000Z', message: { role: 'assistant', usage: { input: 200, output: 50, totalTokens: 250, cost: { total: 0.02, currency: 'USD' } } } }),
    '',
  ].join('\n'));

  assert.deepEqual(summary, {
    input_tokens: 300,
    output_tokens: 75,
    cache_read_tokens: 10,
    cache_write_tokens: 5,
    total_tokens: 390,
    total_cost: 0.03,
    currency: 'USD',
    source: 'pi_session_assistant_usage',
    message_count: 2,
    latest_usage_at: '2026-04-26T00:02:00.000Z',
  });
});

test('final branch head metadata preserves launch head while recording resolved final head', async (t) => {
  const { repo, branch, launchHead, finalHead } = await initGitRepoWithTaskBranch(t);
  const state = await collectFinalBranchHead({ worktreePath: repo, branch });

  assert.equal(state.final_head_commit, finalHead);
  assert.equal(state.final_head_status, 'clean');
  assert.equal(state.final_head_source, 'supplied_branch');
  assert.equal(state.final_branch, branch);
  assert.equal(state.final_worktree_branch, branch);
  assert.equal(state.final_branch_matches_worktree, true);
  assert.equal(state.final_worktree_status, 'clean');

  const metadata = buildSubagentRunMetadata({
    runId: 'run-final-head',
    role: 'coder',
    taskId: 954,
    cwd: repo,
    backend: 'pi-cli',
    worktreePath: repo,
    branch,
    headCommit: launchHead,
    purpose: 'implementation',
  }, buildFinalBranchHeadMetadata(state));

  assert.equal(metadata.head_commit, launchHead);
  assert.equal(metadata.final_head_commit, finalHead);
  assert.notEqual(metadata.head_commit, metadata.final_head_commit);
  assert.equal(metadata.final_head_status, 'clean');
  assert.equal(metadata.final_worktree_status, 'clean');
});

test('final branch head inspection reports dirty uncommitted work explicitly', async (t) => {
  const { repo, branch, finalHead } = await initGitRepoWithTaskBranch(t, 'task/dirty-final-head');
  await writeFile(path.join(repo, 'work.txt'), 'final plus uncommitted edit\n', 'utf8');
  await writeFile(path.join(repo, 'untracked.txt'), 'untracked\n', 'utf8');

  const state = await collectFinalBranchHead({ worktreePath: repo, branch });

  assert.equal(state.final_head_commit, finalHead);
  assert.equal(state.final_head_status, 'dirty_uncommitted');
  assert.equal(state.final_worktree_status, 'dirty_uncommitted');
  assert.match(state.final_worktree_status_short, /M work\.txt/);
  assert.match(state.final_worktree_status_short, /\?\? untracked\.txt/);
});

test('final branch head inspection reports branch mismatches while resolving the requested branch', async (t) => {
  const { repo, branch, finalHead } = await initGitRepoWithTaskBranch(t, 'task/mismatched-final-head');
  await git(repo, ['checkout', 'main']);

  const state = await collectFinalBranchHead({ worktreePath: repo, branch });

  assert.equal(state.final_head_commit, finalHead);
  assert.equal(state.final_head_status, 'branch_mismatch');
  assert.equal(state.final_branch, branch);
  assert.equal(state.final_worktree_branch, 'main');
  assert.equal(state.final_branch_matches_worktree, false);
  assert.equal(state.final_worktree_status, 'clean');
});

test('final branch head inspection reports unavailable worktrees without a commit claim', async () => {
  const missing = path.join(os.tmpdir(), `den-missing-final-head-${Date.now()}`);
  const state = await collectFinalBranchHead({ worktreePath: missing, branch: 'task/missing' });

  assert.equal(state.final_head_commit, undefined);
  assert.equal(state.final_head_status, 'unavailable');
  assert.equal(state.final_worktree_status, 'unavailable');
  assert.match(state.final_head_error, /worktree_path unavailable/);
});

test('subagent run recorder writes normalized artifacts and ordered progress events', async (t) => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = await mkdtemp(path.join(os.tmpdir(), 'den-subagent-recorder-'));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  });

  const progress = [];
  const recorder = await createSubagentRunRecorder('run-recorder', {
    progressPublisher(event) {
      progress.push(event);
    },
  });

  await recorder.writeStatus({ state: 'starting', run_id: 'run-recorder' });
  await recorder.appendEvent({ type: 'subagent.heartbeat', duration_ms: 1200 });
  await recorder.flushEvents();
  await recorder.appendStdoutLine('{"type":"message_end"}');
  await recorder.appendRawStdout('plain output');
  await recorder.appendStderr('stderr line\n');

  const eventText = await readFile(recorder.artifacts.events_jsonl_path, 'utf8');
  const statusText = await readFile(recorder.artifacts.status_json_path, 'utf8');
  const stdoutText = await readFile(recorder.artifacts.stdout_jsonl_path, 'utf8');
  const stderrText = await readFile(recorder.artifacts.stderr_log_path, 'utf8');

  assert.equal(recorder.artifacts.dir, path.join(agentDir, 'den-subagent-runs', 'run-recorder'));
  assert.equal(recorder.artifacts.session_dir, path.join(agentDir, 'den-subagent-runs', 'run-recorder', 'sessions'));
  assert.match(statusText, /"state": "starting"/);
  assert.match(eventText, /"schema":"den_subagent_run"/);
  assert.match(eventText, /"type":"subagent.heartbeat"/);
  assert.equal(progress.length, 1);
  assert.equal(progress[0].schema, SUBAGENT_RUN_SCHEMA);
  assert.equal(progress[0].schema_version, SUBAGENT_RUN_SCHEMA_VERSION);
  assert.match(stdoutText, /"type":"message_end"/);
  assert.match(stdoutText, /"type":"raw_stdout"/);
  assert.equal(stderrText, 'stderr line\n');
});

test('den prompt template fallbacks enforce delegated coder and reviewer guardrails', () => {
  const coderPrompt = fallbackPrompt(CODER_PROMPT_SLUG);
  assert.match(coderPrompt, /coder_context_packet/);
  assert.match(coderPrompt, /implementation_packet/);
  assert.match(coderPrompt, /Do not merge/i);
  assert.match(coderPrompt, /do not broaden scope/i);
  assert.match(coderPrompt, /Do not change test\/scoring harnesses/i);
  assert.match(coderPrompt, /Do not silently skip failing tests/i);
  assert.match(coderPrompt, /Acceptance checklist/i);

  const reviewerPrompt = fallbackPrompt(REVIEWER_PROMPT_SLUG);
  assert.match(reviewerPrompt, /implementation_packet/);
  assert.match(reviewerPrompt, /drift_check_packet/);
  assert.match(reviewerPrompt, /acceptance criterion/i);
  assert.match(reviewerPrompt, /packet accurately describes the actual diff/i);
  assert.match(reviewerPrompt, /scope drift/i);
  assert.match(reviewerPrompt, /test\/scoring harness/i);
  assert.match(reviewerPrompt, /blocking.*follow-up.*informational/s);
  assert.match(reviewerPrompt, /structured review findings only for actionable issues/i);
  assert.match(reviewerPrompt, /positive summaries.*verdict\/notes text/is);
  assert.match(reviewerPrompt, /genuine follow-up candidates/i);
  assert.match(reviewerPrompt, /do not create structured findings for positive summaries or non-actionable notes/i);
});

test('reviewer prompt template includes reviewer identity guidance and attribution instructions', () => {
  const reviewerPrompt = fallbackPrompt(REVIEWER_PROMPT_SLUG);

  // The template has the reviewer_identity placeholder.
  assert.match(reviewerPrompt, /\{\{reviewer_identity\}\}/);

  // Identity attribution instructions cover the key review tools.
  assert.match(reviewerPrompt, /create_review_finding.*created_by.*reviewer_identity/s);
  assert.match(reviewerPrompt, /set_review_verdict.*decided_by.*reviewer_identity/s);
  assert.match(reviewerPrompt, /post_review_findings.*sender.*reviewer_identity/s);
  assert.match(reviewerPrompt, /set_review_finding_status.*updated_by.*reviewer_identity/s);

  // Anti-pattern: don't use parent identity.
  assert.match(reviewerPrompt, /Do not use the parent orchestrator identity/);
});

test('buildReviewerIdentity produces correct identity strings', () => {
  // Standard case: agent + role.
  assert.equal(buildReviewerIdentity('pi', 'reviewer'), 'pi-reviewer');

  // Already suffixed: no double-suffixing.
  assert.equal(buildReviewerIdentity('pi-reviewer', 'reviewer'), 'pi-reviewer');

  // Case normalization.
  assert.equal(buildReviewerIdentity('PI', 'Reviewer'), 'pi-reviewer');

  // Whitespace trimming.
  assert.equal(buildReviewerIdentity(' pi ', ' reviewer '), 'pi-reviewer');

  // Defaults.
  assert.equal(buildReviewerIdentity('', 'reviewer'), 'pi-reviewer');
  assert.equal(buildReviewerIdentity('pi', ''), 'pi-reviewer');
  assert.equal(buildReviewerIdentity('', ''), 'pi-reviewer');

  // Non-reviewer role.
  assert.equal(buildReviewerIdentity('pi', 'planner'), 'pi-planner');
});

test('reviewer prompt renders with reviewer identity substituted', () => {
  const prompt = renderTemplate(fallbackPrompt(REVIEWER_PROMPT_SLUG), {
    project_id: 'den-mcp',
    task_id: '1079',
    task_title: 'Clarify reviewer identity',
    task_description: 'Make review attribution consistent.',
    task_context: '(no additional context)',
    review_target: 'task/1079-reviewer-identity-audit',
    extra_notes: '',
    reviewer_identity: 'pi-reviewer',
    role: 'reviewer',
  });

  assert.match(prompt, /Your reviewer identity is: `pi-reviewer`/);
  assert.match(prompt, /create_review_finding.*pi-reviewer/s);
  assert.match(prompt, /set_review_verdict.*pi-reviewer/s);
  assert.match(prompt, /post_review_findings.*pi-reviewer/s);
  assert.match(prompt, /Do not use the parent orchestrator identity/);
});

test('reviewerIdentityGuidanceSection produces consistent guidance with placeholder', () => {
  const section = reviewerIdentityGuidanceSection();

  // Starts with the heading.
  assert.match(section, /^## Reviewer Identity$/m);
  assert.match(section, /\{\{reviewer_identity\}\}/);

  // Covers all key review tool fields.
  assert.match(section, /create_review_finding.*created_by/s);
  assert.match(section, /set_review_verdict.*decided_by/s);
  assert.match(section, /respond_to_review_finding.*responded_by/s);
  assert.match(section, /set_review_finding_status.*updated_by/s);
  assert.match(section, /post_review_findings.*sender/s);
  assert.match(section, /request_review.*requested_by/s);
  assert.match(section, /Do not use the parent orchestrator identity/);
});

test('ensureReviewerIdentitySection injects guidance into custom prompts without identity section', () => {
  // Simulate a custom project reviewer prompt that does NOT include the identity section.
  const customPrompt = [
    '# Custom Reviewer Prompt',
    '',
    'Review the code for task #{{task_id}}.',
    '',
    '## Task Context',
    '',
    '{{task_context}}',
  ].join('\n');

  // Render with reviewer_identity substituted.
  const rendered = renderTemplate(customPrompt, {
    project_id: 'den-mcp',
    task_id: '999',
    task_title: 'Test',
    task_description: '',
    task_context: 'Some context',
    review_target: '',
    extra_notes: '',
    reviewer_identity: 'pi-reviewer',
    role: 'reviewer',
  });

  const result = ensureReviewerIdentitySection(rendered, 'pi-reviewer');

  // Identity section is injected after the first heading.
  assert.match(result, /^## Reviewer Identity$/m);
  assert.match(result, /Your reviewer identity is: `pi-reviewer`/);
  assert.match(result, /Do not use the parent orchestrator identity/);

  // Original content is preserved.
  assert.match(result, /Custom Reviewer Prompt/);
  assert.match(result, /Review the code for task #999/);
  assert.match(result, /Some context/);

  // Identity section comes before ## Task Context.
  const identityIdx = result.indexOf('## Reviewer Identity');
  const taskCtxIdx = result.indexOf('## Task Context');
  assert.ok(identityIdx < taskCtxIdx, 'Reviewer Identity should come before Task Context');
});

test('ensureReviewerIdentitySection is idempotent when prompt already has identity section', () => {
  const prompt = renderTemplate(fallbackPrompt(REVIEWER_PROMPT_SLUG), {
    project_id: 'den-mcp',
    task_id: '999',
    task_title: 'Test',
    task_description: '',
    task_context: '',
    review_target: '',
    extra_notes: '',
    reviewer_identity: 'pi-reviewer',
    role: 'reviewer',
  });

  const result = ensureReviewerIdentitySection(prompt, 'pi-reviewer');

  // No duplicate sections — returned as-is. — returned as-is.
  assert.equal(result, prompt);
});

test('ensureReviewerIdentitySection injects into headingless prompt by prepending', () => {
  const plainPrompt = 'Just a plain reviewer prompt with no markdown headings.';
  const result = ensureReviewerIdentitySection(plainPrompt, 'pi-reviewer');

  assert.match(result, /^## Reviewer Identity/m);
  assert.match(result, /Just a plain reviewer prompt/);

  // Identity section comes first.
  const identityIdx = result.indexOf('## Reviewer Identity');
  const plainIdx = result.indexOf('Just a plain');
  assert.ok(identityIdx < plainIdx, 'Identity section should be prepended');
});

test('taskMessages extracts messages from task detail with multiple key conventions', () => {
  const withSnakeCase = { recent_messages: [{ id: 1 }], task: {} };
  assert.deepEqual(taskMessages(withSnakeCase), [{ id: 1 }]);

  const withCamelCase = { recentMessages: [{ id: 2 }], task: {} };
  assert.deepEqual(taskMessages(withCamelCase), [{ id: 2 }]);

  const withGeneric = { messages: [{ id: 3 }], task: {} };
  assert.deepEqual(taskMessages(withGeneric), [{ id: 3 }]);

  // snake_case takes precedence
  const both = { recent_messages: [{ id: 1 }], recentMessages: [{ id: 2 }], task: {} };
  assert.deepEqual(taskMessages(both), [{ id: 1 }]);

  assert.deepEqual(taskMessages({}), []);
  assert.deepEqual(taskMessages(null), []);
  assert.deepEqual(taskMessages(undefined), []);
});

test('den task context summary includes structured workflow packets from recent messages', () => {
  const context = summarizeTaskContext({
    task: { status: 'in_progress', assigned_to: 'pi', tags: ['prompts'] },
    dependencies: [{ task_id: 933, title: 'Define packet conventions' }],
    recent_messages: [
      {
        id: 12,
        sender: 'pi',
        intent: 'handoff',
        metadata: { type: 'coder_context_packet' },
        content: '## Acceptance criteria\n- Use the curated packet\n- Stay bounded',
      },
      {
        id: 11,
        sender: 'coder',
        intent: 'handoff',
        metadata: JSON.stringify({ type: 'implementation_packet' }),
        content: 'Branch: task/935-delegated-prompts',
      },
    ],
  });

  assert.match(context, /Status: in_progress/);
  assert.match(context, /#933 Define packet conventions/);
  assert.match(context, /Latest coder_context_packet/);
  assert.match(context, /Use the curated packet/);
  assert.match(context, /Latest implementation_packet/);
  assert.match(context, /\[coder_context_packet\]/);
});

test('den prompt templates render curated context placeholders', () => {
  const prompt = renderTemplate(fallbackPrompt(CODER_PROMPT_SLUG), {
    project_id: 'den-mcp',
    task_id: '935',
    task_title: 'Update prompts',
    task_description: 'Acceptance criteria:\n- A\n- B',
    task_context: 'Latest coder_context_packet (#1 from pi):\n---\nPacket body\n---',
    review_target: '',
    extra_notes: 'Do not touch unrelated docs.',
    role: 'coder',
  });

  assert.match(prompt, /Project: den-mcp/);
  assert.match(prompt, /Task: #935 Update prompts/);
  assert.match(prompt, /Packet body/);
  assert.match(prompt, /Do not touch unrelated docs/);
});

test('pi cli runner helpers keep prompt, session, and success semantics stable', () => {
  const prompt = buildSubagentPrompt(
    { projectId: 'den-mcp', agent: 'pi', role: 'conductor', instanceId: 'pi-main', baseUrl: 'http://den' },
    { role: 'planner', taskId: 775, prompt: 'Reply with exactly: OK' },
  );
  assert.match(prompt, /fresh planner sub-agent/);
  assert.match(prompt, /Project: den-mcp/);
  assert.match(prompt, /Den task: #775/);
  assert.match(prompt, /Reply with exactly: OK/);

  const freshArgs = [];
  addSessionArgs(freshArgs, 'fresh');
  assert.deepEqual(freshArgs, ['--no-session']);

  const persistedFreshArgs = [];
  addSessionArgs(persistedFreshArgs, 'fresh', undefined, '/tmp/run/sessions');
  assert.deepEqual(persistedFreshArgs, ['--session-dir', '/tmp/run/sessions']);

  const forkArgs = [];
  addSessionArgs(forkArgs, 'fork', 'session-1');
  assert.deepEqual(forkArgs, ['--fork', 'session-1']);
  assert.throws(() => addSessionArgs([], 'session'), /session is required/);

  assert.equal(subagentSucceeded({ assistant_final_found: true, aborted: false, exit_code: 0 }), true);
  assert.equal(subagentSucceeded({
    assistant_final_found: true,
    aborted: false,
    exit_code: 143,
    timeout_kind: 'terminal_drain',
  }), true);
  assert.equal(subagentSucceeded({ assistant_final_found: false, aborted: false, exit_code: 0 }), false);
  assert.equal(subagentSucceeded({ assistant_final_found: true, aborted: true, exit_code: 0 }), false);
});

test('pi cli runner observes Den abort control request and terminates child', async (t) => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousPiBin = process.env.DEN_PI_SUBAGENT_PI_BIN;
  const previousPollMs = process.env.DEN_PI_SUBAGENT_CONTROL_POLL_MS;
  const previousStartupMs = process.env.DEN_PI_SUBAGENT_STARTUP_TIMEOUT_MS;
  const previousForceKillMs = process.env.DEN_PI_SUBAGENT_FORCE_KILL_MS;
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'den-subagent-abort-'));
  const fakePi = path.join(tmp, 'fake-pi');
  await writeFile(fakePi, [
    '#!/usr/bin/env bash',
    'trap "exit 143" TERM',
    'while true; do sleep 1; done',
    '',
  ].join('\n'), 'utf8');
  await chmod(fakePi, 0o755);

  process.env.PI_CODING_AGENT_DIR = path.join(tmp, 'agent');
  process.env.DEN_PI_SUBAGENT_PI_BIN = fakePi;
  process.env.DEN_PI_SUBAGENT_CONTROL_POLL_MS = '25';
  process.env.DEN_PI_SUBAGENT_STARTUP_TIMEOUT_MS = '10000';
  process.env.DEN_PI_SUBAGENT_FORCE_KILL_MS = '1000';
  t.after(async () => {
    restoreEnv('PI_CODING_AGENT_DIR', previousAgentDir);
    restoreEnv('DEN_PI_SUBAGENT_PI_BIN', previousPiBin);
    restoreEnv('DEN_PI_SUBAGENT_CONTROL_POLL_MS', previousPollMs);
    restoreEnv('DEN_PI_SUBAGENT_STARTUP_TIMEOUT_MS', previousStartupMs);
    restoreEnv('DEN_PI_SUBAGENT_FORCE_KILL_MS', previousForceKillMs);
    await rm(tmp, { recursive: true, force: true });
  });

  const recorder = await createSubagentRunRecorder('run-abort-control');
  let polls = 0;
  const result = await runPiCliSubagent({
    cfg: { projectId: 'den-mcp', agent: 'pi', role: 'conductor', instanceId: 'pi-main', baseUrl: 'http://den' },
    options: { role: 'planner', prompt: 'wait forever' },
    cwd: tmp,
    runId: 'run-abort-control',
    recorder,
    startedAt: new Date().toISOString(),
    signal: undefined,
    controlSource: {
      async poll() {
        polls++;
        return polls === 1
          ? { action: 'abort', entryId: 42, requestedBy: 'web-ui', reason: 'test abort' }
          : undefined;
      },
    },
    onUpdate: undefined,
  });

  assert.equal(result.aborted, true);
  assert.equal(result.infrastructure_failure_reason, 'aborted');
  assert.equal(subagentSucceeded(result), false);

  const eventText = await readFile(recorder.artifacts.events_jsonl_path, 'utf8');
  const statusText = await readFile(recorder.artifacts.status_json_path, 'utf8');
  assert.match(eventText, /"type":"subagent.abort"/);
  assert.match(eventText, /"request_entry_id":42/);
  assert.match(eventText, /"requested_by":"web-ui"/);
  assert.match(statusText, /"state": "aborted"/);
});

test('pi cli runner suppresses prompt-echo-only output when child exits 143', async (t) => {
  const { result, recorder } = await runFakePiSubagent(t, {
    prefix: 'den-subagent-echo-143-',
    runId: 'run-prompt-echo-143',
    scriptLines: [
      '#!/usr/bin/env node',
      'const prompt = process.argv[process.argv.length - 1];',
      'console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", model: "gpt-test", stopReason: "stop", content: [{ type: "text", text: prompt }] } }));',
      'process.exit(143);',
    ],
    options: { role: 'reviewer', taskId: 772, prompt: 'Review the current branch and finish with a verdict.' },
  });

  assert.equal(result.exit_code, 143);
  assert.equal(result.signal, undefined);
  assert.equal(result.final_output, '');
  assert.equal(result.assistant_final_found, false);
  assert.equal(result.prompt_echo_detected, true);
  assert.equal(result.output_status, 'prompt_echo_only');
  assert.equal(result.message_count, 1);
  assert.equal(result.assistant_message_count, 1);
  assert.equal(subagentSucceeded(result), false);

  const status = await readJson(recorder.artifacts.status_json_path);
  const events = await readJsonLines(recorder.artifacts.events_jsonl_path);
  const stdout = await readJsonLines(recorder.artifacts.stdout_jsonl_path);
  assert.equal(status.state, 'failed');
  assert.equal(status.output_status, 'prompt_echo_only');
  assert.equal(status.exit_code, 143);
  assert.ok(events.some((event) => event.type === 'subagent.prompt_echo_detected'));
  assert.ok(stdout.some((event) => event.type === 'message_end'));
});

test('pi cli runner times out children that never emit JSON', async (t) => {
  const { result, recorder } = await runFakePiSubagent(t, {
    prefix: 'den-subagent-startup-timeout-',
    runId: 'run-no-json-startup-timeout',
    scriptLines: [
      '#!/usr/bin/env node',
      'process.stderr.write("fake child started without json\\n");',
      'process.on("SIGTERM", () => process.exit(143));',
      'setInterval(() => {}, 1000);',
    ],
    env: {
      DEN_PI_SUBAGENT_STARTUP_TIMEOUT_MS: '100',
      DEN_PI_SUBAGENT_FORCE_KILL_MS: '500',
    },
    options: { role: 'planner', prompt: 'Wait for JSON that will never arrive.' },
  });

  assert.equal(result.timeout_kind, 'startup');
  assert.equal(result.aborted, false);
  assert.equal(result.forced_kill, false);
  assert.equal(result.assistant_final_found, false);
  assert.equal(result.output_status, 'no_assistant_final');
  assert.equal(result.infrastructure_failure_reason, 'timeout');
  assert.equal(subagentSucceeded(result), false);
  assert.ok(result.pid > 0);
  assert.ok(Date.parse(result.started_at) <= Date.parse(result.ended_at));
  assert.ok(result.duration_ms >= 0);
  assert.match(result.stderr_tail, /fake child started without json/);

  const status = await readJson(recorder.artifacts.status_json_path);
  const events = await readJsonLines(recorder.artifacts.events_jsonl_path);
  const stderr = await readFile(recorder.artifacts.stderr_log_path, 'utf8');
  assert.equal(status.state, 'timeout');
  assert.equal(status.timeout_kind, 'startup');
  assert.equal(status.pid, result.pid);
  assert.ok(events.some((event) => event.type === 'subagent.process_started'));
  assert.ok(events.some((event) => event.type === 'subagent.startup_timeout'));
  assert.ok(events.some((event) => event.type === 'subagent.process_finished'));
  assert.match(stderr, /fake child started without json/);
});

test('pi cli runner preserves assistant final output when terminal drain guard kills stuck child', async (t) => {
  const updates = [];
  const { result, recorder } = await runFakePiSubagent(t, {
    prefix: 'den-subagent-terminal-drain-',
    runId: 'run-terminal-drain-final-output',
    scriptLines: [
      '#!/usr/bin/env node',
      'process.on("SIGTERM", () => process.exit(143));',
      'console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", model: "gpt-test", stopReason: "stop", content: [{ type: "text", text: "final answer before stuck handles" }] } }));',
      'setInterval(() => {}, 1000);',
    ],
    env: {
      DEN_PI_SUBAGENT_STARTUP_TIMEOUT_MS: '1000',
      DEN_PI_SUBAGENT_FINAL_DRAIN_MS: '25',
      DEN_PI_SUBAGENT_FORCE_KILL_MS: '500',
    },
    options: { role: 'coder', prompt: 'Produce a final answer and then keep handles open.' },
    onUpdate(partial) {
      updates.push(partial);
    },
  });

  assert.equal(result.final_output, 'final answer before stuck handles');
  assert.equal(result.assistant_final_found, true);
  assert.equal(result.prompt_echo_detected, false);
  assert.equal(result.output_status, 'assistant_final');
  assert.equal(result.timeout_kind, 'terminal_drain');
  assert.equal(result.forced_kill, false);
  assert.equal(subagentSucceeded(result), true);
  assert.deepEqual(updates, ['final answer before stuck handles']);

  const status = await readJson(recorder.artifacts.status_json_path);
  const events = await readJsonLines(recorder.artifacts.events_jsonl_path);
  assert.equal(status.state, 'complete');
  assert.equal(status.timeout_kind, 'terminal_drain');
  assert.equal(status.output_status, 'assistant_final');
  assert.ok(events.some((event) => event.type === 'subagent.assistant_output'));
  assert.ok(events.some((event) => event.type === 'subagent.terminal_drain_timeout'));
  assert.ok(events.some((event) => event.type === 'subagent.process_finished'));
});

test('pi cli runner carries conductor context into status, result, and lifecycle events', async (t) => {
  const { result, recorder } = await runFakePiSubagent(t, {
    prefix: 'den-subagent-context-metadata-',
    runId: 'run-context-metadata',
    scriptLines: [
      '#!/usr/bin/env node',
      'console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", model: "gpt-test", stopReason: "stop", content: [{ type: "text", text: "context preserved" }] } }));',
      'process.exit(0);',
    ],
    options: {
      role: 'reviewer',
      taskId: 808,
      prompt: 'Review the current branch.',
      reviewRoundId: 135,
      workspaceId: 'workspace-1',
      worktreePath: '/tmp/worktrees/den-808',
      branch: 'task/808-subagent-context-metadata',
      baseBranch: 'main',
      baseCommit: 'base-sha',
      headCommit: 'head-sha',
      purpose: 'Review Follow-Up',
    },
  });

  assert.equal(result.exit_code, 0);
  assert.equal(result.review_round_id, 135);
  assert.equal(result.workspace_id, 'workspace-1');
  assert.equal(result.worktree_path, '/tmp/worktrees/den-808');
  assert.equal(result.branch, 'task/808-subagent-context-metadata');
  assert.equal(result.base_branch, 'main');
  assert.equal(result.base_commit, 'base-sha');
  assert.equal(result.head_commit, 'head-sha');
  assert.equal(result.purpose, 'review_follow_up');

  const status = await readJson(recorder.artifacts.status_json_path);
  const events = await readJsonLines(recorder.artifacts.events_jsonl_path);
  assert.equal(status.review_round_id, 135);
  assert.equal(status.workspace_id, 'workspace-1');
  assert.equal(status.worktree_path, '/tmp/worktrees/den-808');
  assert.equal(status.branch, 'task/808-subagent-context-metadata');
  assert.equal(status.base_branch, 'main');
  assert.equal(status.base_commit, 'base-sha');
  assert.equal(status.head_commit, 'head-sha');
  assert.equal(status.purpose, 'review_follow_up');
  assert.ok(events.some((event) => event.type === 'subagent.process_started' && event.review_round_id === 135 && event.purpose === 'review_follow_up'));
  assert.ok(events.some((event) => event.type === 'subagent.process_finished' && event.review_round_id === 135 && event.branch === 'task/808-subagent-context-metadata'));
});

test('pi cli runner records child session file metadata when fresh runs persist sessions', async (t) => {
  const { result, recorder } = await runFakePiSubagent(t, {
    prefix: 'den-subagent-session-file-',
    runId: 'run-session-file',
    scriptLines: [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const sessionDir = process.argv[process.argv.indexOf("--session-dir") + 1];',
      'const sessionId = "session-test-123";',
      'fs.mkdirSync(sessionDir, { recursive: true });',
      'const sessionFile = path.join(sessionDir, `2026-04-26T00-00-00-000Z_${sessionId}.jsonl`);',
      'fs.writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-04-26T00:00:00.000Z", cwd: process.cwd() }) + "\\n");',
      'fs.appendFileSync(sessionFile, JSON.stringify({ type: "message", id: "a1", parentId: null, timestamp: "2026-04-26T00:00:01.000Z", message: { role: "assistant", provider: "fake", model: "gpt-test", stopReason: "stop", content: [{ type: "text", text: "session-backed final" }] } }) + "\\n");',
      'console.log(JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: process.cwd() }));',
      'console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", model: "gpt-test", stopReason: "stop", content: [{ type: "text", text: "session-backed final" }] } }));',
      'process.exit(0);',
    ],
    options: { role: 'coder', prompt: 'Create a persisted child session.' },
  });

  assert.equal(result.exit_code, 0);
  assert.equal(result.pi_session_persisted, true);
  assert.equal(result.pi_session_id, 'session-test-123');
  assert.equal(result.pi_session_dir, recorder.artifacts.session_dir);
  assert.equal(result.pi_session_file_path, path.join(recorder.artifacts.session_dir, '2026-04-26T00-00-00-000Z_session-test-123.jsonl'));
  assert.equal(result.artifacts.session_id, 'session-test-123');
  assert.equal(result.artifacts.session_file_path, result.pi_session_file_path);

  const status = await readJson(recorder.artifacts.status_json_path);
  const events = await readJsonLines(recorder.artifacts.events_jsonl_path);
  assert.equal(status.pi_session_id, 'session-test-123');
  assert.equal(status.pi_session_file_path, result.pi_session_file_path);
  assert.equal(status.artifacts.session_file_path, result.pi_session_file_path);
  assert.ok(events.some((event) => event.type === 'subagent.work_session' && event.session_id === 'session-test-123'));
  assert.ok(events.some((event) => event.type === 'subagent.session_file_detected' && event.pi_session_file_path === result.pi_session_file_path));
});

test('pi cli runner records normalized work events from child Pi stream', async (t) => {
  const { result, recorder } = await runFakePiSubagent(t, {
    prefix: 'den-subagent-work-events-',
    runId: 'run-normalized-work-events',
    scriptLines: [
      '#!/usr/bin/env node',
      'console.log(JSON.stringify({ type: "turn_start" }));',
      'console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: { command: "echo ok" } }));',
      'console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "bash", result: { content: [{ type: "text", text: "ok\\n" }] }, isError: false }));',
      'console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta" }, message: { role: "assistant", model: "gpt-test", stopReason: "stop", content: [{ type: "text", text: "Tests passed." }] } }));',
      'console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", model: "gpt-test", stopReason: "stop", content: [{ type: "text", text: "final answer" }] } }));',
      'process.exit(0);',
    ],
    options: { role: 'coder', prompt: 'Run a tool and summarize it.' },
  });

  assert.equal(result.exit_code, 0);
  assert.equal(result.final_output, 'final answer');
  const events = await readJsonLines(recorder.artifacts.events_jsonl_path);
  assert.ok(events.some((event) => event.type === 'subagent.work_turn_start'));
  assert.ok(events.some((event) => event.type === 'subagent.work_tool_start' && event.tool_name === 'bash' && event.args_preview.includes('echo ok')));
  assert.ok(events.some((event) => event.type === 'subagent.work_tool_end' && event.result_preview.includes('ok') && event.is_error === false));
  assert.ok(events.some((event) => event.type === 'subagent.work_message_update' && event.text_preview === 'Tests passed.'));
  assert.ok(events.some((event) => event.type === 'subagent.work_message_end' && event.text_preview === 'final answer'));
  assert.ok(events.some((event) => event.type === 'subagent.assistant_output'));
});

test('pi cli runner applies configured reasoning capture to status and work events', async (t) => {
  const previous = process.env.DEN_PI_SUBAGENT_RAW_REASONING;
  delete process.env.DEN_PI_SUBAGENT_RAW_REASONING;
  t.after(() => restoreEnv('DEN_PI_SUBAGENT_RAW_REASONING', previous));

  const { recorder } = await runFakePiSubagent(t, {
    prefix: 'den-subagent-reasoning-config-oit-',
    runId: 'run-reasoning-config',
    scriptLines: [
      '#!/usr/bin/env node',
      'console.log(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "reasoning_delta", delta: "checking Den config controls" }, message: { role: "assistant", provider: "openai", model: "gpt-test", content: [{ type: "reasoning", reasoning: "checking Den config controls" }] } }));',
      'console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", model: "gpt-test", stopReason: "stop", content: [{ type: "text", text: "done" }] } }));',
      'process.exit(0);',
    ],
    options: {
      role: 'coder',
      prompt: 'Check reasoning config.',
      reasoningCapture: { captureRawLocalPreviews: true, previewChars: 13 },
    },
  });

  const status = await readJson(recorder.artifacts.status_json_path);
  assert.deepEqual(status.reasoning_capture, {
    capture_provider_summaries: true,
    capture_raw_local_previews: true,
    preview_chars: 13,
    raw_env_override: false,
  });

  const events = await readJsonLines(recorder.artifacts.events_jsonl_path);
  const reasoning = events.find((event) => event.type === 'subagent.work_reasoning_update');
  assert.equal(reasoning?.reasoning_redacted, false);
  assert.equal(reasoning?.text_preview, 'checking Den…');
});


test('pi cli runner does not terminal-drain partial assistant tool-use turns', async (t) => {
  const updates = [];
  const { result, recorder } = await runFakePiSubagent(t, {
    prefix: 'den-subagent-tool-use-preface-',
    runId: 'run-tool-use-preface-not-final',
    scriptLines: [
      '#!/usr/bin/env node',
      'process.on("SIGTERM", () => process.exit(143));',
      'console.log(JSON.stringify({ type: "message_update", message: { role: "assistant", model: "gpt-test", stopReason: "stop", content: [{ type: "text", text: "Now let me run the tests." }] } }));',
      'setTimeout(() => console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", model: "gpt-test", stopReason: "toolUse", content: [{ type: "text", text: "Now let me run the tests." }, { type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "node --test" } }] } })), 50);',
      'setTimeout(() => console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", model: "gpt-test", stopReason: "stop", content: [{ type: "text", text: "actual final verdict" }] } })), 90);',
      'setTimeout(() => process.exit(0), 100);',
    ],
    env: {
      DEN_PI_SUBAGENT_STARTUP_TIMEOUT_MS: '1000',
      DEN_PI_SUBAGENT_FINAL_DRAIN_MS: '25',
      DEN_PI_SUBAGENT_FORCE_KILL_MS: '500',
    },
    options: { role: 'reviewer', prompt: 'Review the tests, then produce a final verdict.' },
    onUpdate(partial) {
      updates.push(partial);
    },
  });

  assert.equal(result.exit_code, 0);
  assert.equal(result.timeout_kind, undefined);
  assert.equal(result.final_output, 'actual final verdict');
  assert.equal(result.assistant_final_found, true);
  assert.equal(result.output_status, 'assistant_final');
  assert.equal(subagentSucceeded(result), true);
  assert.deepEqual(updates, ['actual final verdict']);

  const status = await readJson(recorder.artifacts.status_json_path);
  const events = await readJsonLines(recorder.artifacts.events_jsonl_path);
  assert.equal(status.state, 'complete');
  assert.equal(status.timeout_kind, null);
  assert.equal(status.output_status, 'assistant_final');
  assert.ok(events.some((event) => event.type === 'subagent.assistant_output'));
  assert.equal(events.some((event) => event.type === 'subagent.terminal_drain_timeout'), false);
});

test('output extractor accepts assistant final output and records model', () => {
  const events = [];
  const extractor = createSubagentOutputExtractor('Say hi', {
    appendEvent(event) {
      events.push(event);
    },
  });

  const output = extractor.updateFromEvent({
    type: 'message_end',
    message: assistantMessage('hello'),
  });

  assert.equal(output, 'hello');
  assert.deepEqual(extractor.snapshot(), {
    finalOutput: 'hello',
    model: 'gpt-test',
    messageCount: 1,
    assistantMessageCount: 1,
    promptEchoDetected: false,
    childErrorMessage: undefined,
  });
  assert.equal(events[0].type, 'subagent.assistant_output');
});

test('output extractor ignores assistant tool-use prefaces as final output', () => {
  const events = [];
  const extractor = createSubagentOutputExtractor('Run tests', {
    appendEvent(event) {
      events.push(event);
    },
  });

  const output = extractor.updateFromEvent({
    type: 'message_end',
    message: assistantMessage('Now let me run the tests.', {
      stopReason: 'toolUse',
      content: [
        { type: 'text', text: 'Now let me run the tests.' },
        { type: 'toolCall', id: 'tool-1', name: 'bash', arguments: { command: 'node --test' } },
      ],
    }),
  });

  assert.equal(output, undefined);
  assert.deepEqual(extractor.snapshot(), {
    finalOutput: '',
    model: 'gpt-test',
    messageCount: 1,
    assistantMessageCount: 1,
    promptEchoDetected: false,
    childErrorMessage: undefined,
  });
  assert.deepEqual(events, []);
});

test('output extractor ignores user prompt echoes', () => {
  const prompt = 'Reply with exactly: SUBAGENT_SMOKE_OK';
  const extractor = createSubagentOutputExtractor(prompt);

  const output = extractor.updateFromEvent({
    type: 'message_end',
    message: {
      role: 'user',
      content: [{ type: 'text', text: prompt }],
    },
  });

  assert.equal(output, undefined);
  assert.equal(extractor.snapshot().finalOutput, '');
  assert.equal(extractor.snapshot().promptEchoDetected, false);
  assert.equal(extractor.snapshot().messageCount, 1);
  assert.equal(extractor.snapshot().assistantMessageCount, 0);
});

test('output extractor classifies assistant prompt echoes as unusable', () => {
  const prompt = 'This is a deliberately long prompt that should be detected if an assistant echoes the beginning of it back instead of producing an actual answer.';
  const events = [];
  const extractor = createSubagentOutputExtractor(prompt, {
    appendEvent(event) {
      events.push(event);
    },
  });

  const output = extractor.updateFromEvent({
    type: 'message_end',
    message: assistantMessage(`${prompt}\n\nMore prompt material.`),
  });

  assert.equal(output, undefined);
  assert.equal(extractor.snapshot().finalOutput, '');
  assert.equal(extractor.snapshot().promptEchoDetected, true);
  assert.equal(extractor.snapshot().assistantMessageCount, 1);
  assert.equal(events[0].type, 'subagent.prompt_echo_detected');
});

test('terminal assistant detection excludes tool-call messages', () => {
  assert.equal(isTerminalAssistantMessage(assistantMessage('done')), true);
  assert.equal(isTerminalAssistantMessage(assistantMessage('needs tool', {
    content: [{ type: 'text', text: 'needs tool' }, { type: 'toolCall', name: 'search' }],
  })), false);
  assert.equal(isTerminalAssistantMessage({ role: 'user', content: [{ type: 'text', text: 'hello' }] }), false);
});

test('infrastructure failures are classified before fallback retry', () => {
  assert.equal(isSubagentInfrastructureFailure({ timeout_kind: 'startup' }), true);
  assert.equal(isSubagentInfrastructureFailure({ forced_kill: true }), true);
  assert.equal(isSubagentInfrastructureFailure({ signal: 'SIGTERM' }), true);
  assert.equal(isSubagentInfrastructureFailure({ child_error_message: 'spawn ENOENT' }), true);
  assert.equal(classifySubagentInfrastructureFailure({ child_error_message: 'Provider returned 429 Too Many Requests' }), 'quota');
  assert.equal(classifySubagentInfrastructureFailure({ child_error_message: 'Usage limit reached for 5 hour' }), 'quota');
  assert.equal(classifySubagentInfrastructureFailure({ stderr_tail: 'rate limit exceeded for selected model' }), 'quota');
  assert.equal(classifySubagentInfrastructureFailure({
    stderr_tail: 'Error: Failed to load extension "/tmp/bad.ts": Extension does not export a valid factory function',
  }), 'extension_load');
  assert.equal(classifySubagentInfrastructureFailure({
    stderr: 'Extension error (/tmp/footer.ts): This extension ctx is stale after session replacement or reload.',
  }), 'extension_runtime');
  assert.equal(classifySubagentStderrIssue(
    'Extension error (/tmp/footer.ts): This extension ctx is stale after session replacement or reload.',
  ), 'extension_runtime');
  assert.equal(isSubagentInfrastructureFailure({}), false);
});

test('requested_head_commit alias is set on subagent result from run context', async (t) => {
  const { result } = await runFakePiSubagent(t, {
    prefix: 'den-subagent-requested-head-alias-',
    runId: 'run-requested-head-alias',
    scriptLines: [
      '#!/usr/bin/env node',
      'console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", model: "gpt-test", stopReason: "stop", content: [{ type: "text", text: "done" }] } }));',
      'process.exit(0);',
    ],
    options: {
      role: 'coder',
      prompt: 'Work on the branch.',
      headCommit: 'launch-sha-abc123',
      branch: 'task/test-requested-head',
    },
  });

  assert.equal(result.head_commit, 'launch-sha-abc123');
  assert.equal(result.requested_head_commit, 'launch-sha-abc123');
});

test('coder run that creates new commits records requested_head_commit distinct from final_head_commit', async (t) => {
  const { repo, branch, launchHead, finalHead } = await initGitRepoWithTaskBranch(t, 'task/new-commits');

  // Simulate a result where head_commit = launch head (requested)
  // and final_head_commit = the actual final head after commits.
  const result = {
    run_id: 'run-new-commits',
    role: 'coder',
    task_id: 1080,
    branch,
    head_commit: launchHead,
    exit_code: 0,
    aborted: false,
    assistant_final_found: true,
    final_output: 'Made changes and committed.',
    artifacts: { dir: '/tmp/run-new-commits' },
    duration_ms: 5000,
    message_count: 3,
    assistant_message_count: 2,
    session_mode: 'fresh',
    backend: 'pi-cli',
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
  };

  // Simulate what applyFinalHeadState does
  const finalHeadState = await collectFinalBranchHead({ worktreePath: repo, branch });
  result.requested_head_commit = result.requested_head_commit ?? result.head_commit;
  result.final_head_commit = finalHeadState.final_head_commit;
  result.final_head_status = finalHeadState.final_head_status;
  result.final_branch = finalHeadState.final_branch;
  result.final_worktree_branch = finalHeadState.final_worktree_branch;
  result.final_branch_matches_worktree = finalHeadState.final_branch_matches_worktree;
  result.final_worktree_status = finalHeadState.final_worktree_status;

  // Verify the two heads are distinct
  assert.notEqual(result.requested_head_commit, result.final_head_commit,
    'requested and final heads should differ for a coder run that committed');
  assert.equal(result.requested_head_commit, launchHead,
    'requested_head_commit should be the launch head');
  assert.equal(result.final_head_commit, finalHead,
    'final_head_commit should be the branch tip after commits');

  // Verify parent tool result includes both heads
  const { buildSubagentParentToolResult } = await import('../../lib/den-subagent-parent-tool-result.ts');
  const toolResult = buildSubagentParentToolResult(result);
  assert.equal(toolResult.details.requested_head_commit, launchHead);
  assert.equal(toolResult.details.final_head_commit, finalHead);
  assert.match(toolResult.content[0].text, new RegExp(`Requested \\(starting\\) head: ${launchHead}`));
  assert.match(toolResult.content[0].text, new RegExp(`Final branch head: ${finalHead}`));
});

test('requested_head_commit preserved when no branch/worktree context available', async (t) => {
  const { result } = await runFakePiSubagent(t, {
    prefix: 'den-subagent-no-context-',
    runId: 'run-no-context',
    scriptLines: [
      '#!/usr/bin/env node',
      'console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", model: "gpt-test", stopReason: "stop", content: [{ type: "text", text: "done" }] } }));',
      'process.exit(0);',
    ],
    options: {
      role: 'reviewer',
      prompt: 'Review the branch.',
      // No branch or worktreePath — final head collection cannot run.
      headCommit: 'review-head-sha',
    },
  });

  // Without branch/worktree context, no final head collection occurs for any role
  assert.equal(result.head_commit, 'review-head-sha');
  assert.equal(result.requested_head_commit, 'review-head-sha');
  assert.equal(result.final_head_commit, undefined, 'no final head when no context');
});
